FROM ubuntu:20.04

# Install SSH server
RUN apt-get update && apt-get install -y openssh-server

# Create SSH directory and set permissions
RUN mkdir /var/run/sshd
RUN echo 'root:root' | chpasswd
RUN sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config

# Configure SSH server to allow TCP forwarding
RUN echo "AllowTcpForwarding yes" >> /etc/ssh/sshd_config
RUN echo "GatewayPorts yes" >> /etc/ssh/sshd_config

# Set up a user for SSH tunneling
RUN useradd -m proxyuser && echo "proxyuser:proxypass" | chpasswd && adduser proxyuser sudo

# Expose the SSH port
EXPOSE 22

# Start the SSH server
CMD ["/usr/sbin/sshd", "-D"]
